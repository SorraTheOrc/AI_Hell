/**
 * End-to-end tests for content-adaptive configuration
 * (AH-0MUY08X98002TRHT, AC1–AC5).
 *
 * These prove the acceptance criteria through the public seams:
 *
 * - AC1/AC2 — the shipped registry describes every kind of game content.
 * - AC3 — a **synthetic** enemy / asteroid-like hazard / drop registered only
 *   as a config entry is handled by the brain with no core change.
 * - AC4 — unknown content falls back to a documented default.
 * - AC5 — the lookup and synthetic-content paths are covered here.
 */

import { describe, expect, it } from 'vitest';

import { createBotContent, EMPTY_BOT_CONTENT } from '../content';
import { buildBotWorld } from '../worldModel';
import { drop, enemy, makeSnapshot } from '../testFixtures';
import { POWER_UP_CATALOGUE, WEAPON_DROP_IDS } from '../../../powerups/types';
import { COMPETENT_BOT_CONTENT } from './content';
import { COMPETENT_GOAL_IDS } from './goals';
import { createCompetentBotBrain } from './index';

const PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

/** The archetypes `createEnemyFromConfig` can spawn. */
const SHIPPED_ENEMY_ARCHETYPES = [
  'asteroid',
  'harvester',
  'diver',
  'tank',
  'phaser',
  'swarm',
  'scout',
] as const;

describe('shipped content registry (AC1/AC2)', () => {
  it('describes every enemy archetype the factory can spawn', () => {
    for (const archetype of SHIPPED_ENEMY_ARCHETYPES) {
      expect(COMPETENT_BOT_CONTENT.hasEnemy(archetype)).toBe(true);
    }
  });

  it('describes every power-up and weapon drop the game can spawn', () => {
    const powerUpIds = Object.keys(POWER_UP_CATALOGUE);
    for (const id of [...powerUpIds, ...WEAPON_DROP_IDS]) {
      expect(COMPETENT_BOT_CONTENT.hasDrop(id)).toBe(true);
    }
  });

  it('flags the asteroid archetype as an asteroid-like hazard (AC1)', () => {
    expect(COMPETENT_BOT_CONTENT.isAsteroidLike('asteroid')).toBe(true);
    expect(COMPETENT_BOT_CONTENT.isAsteroidLike('scout')).toBe(false);
  });
});

describe('synthetic content needs only a config entry (AC3)', () => {
  it('engages a synthetic enemy archetype', () => {
    const content = createBotContent({
      enemies: [
        {
          id: 'sapper',
          threat: 1.4,
          engagementRange: 300,
          aim: 'direct',
          asteroidLike: false,
        },
      ],
    });

    const world = buildBotWorld(
      makeSnapshot({ player: PLAYER, enemies: [enemy(680, 270, 'sapper')] }),
      undefined,
      content,
    );
    expect(world.liveEnemies.map((e) => e.archetype)).toEqual(['sapper']);
    expect(world.liveAsteroids).toHaveLength(0);

    const brain = createCompetentBotBrain({ content, fallback: null });
    const intent = brain.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(680, 270, 'sapper')] }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);
    // 200 px away, inside the synthetic 300 px engagement range -> hold aim
    // and coast (the default 140 px range would have had it thrust).
    expect(intent.dirX).toBeCloseTo(1, 3);
    expect(intent.thrust).toBe(false);
  });

  it('partition and engage a synthetic asteroid-like hazard', () => {
    const content = createBotContent({
      enemies: [
        { id: 'void_rock', threat: 1, aim: 'direct', asteroidLike: true },
      ],
    });

    const world = buildBotWorld(
      makeSnapshot({
        player: PLAYER,
        enemies: [enemy(680, 270, 'void_rock')],
      }),
      undefined,
      content,
    );
    expect(world.liveAsteroids.map((e) => e.archetype)).toEqual(['void_rock']);
    expect(world.liveEnemies).toHaveLength(0);

    const brain = createCompetentBotBrain({ content, fallback: null });
    brain.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(680, 270, 'void_rock')] }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageAsteroid);
  });

  it('collects a synthetic high-value drop ahead of a nearer normal one (AC2)', () => {
    const content = createBotContent({
      drops: [{ id: 'quantum_core', value: 1.5 }],
    });
    // A normal drop 200 px to the left, a synthetic one 250 px to the right:
    // the synthetic drop's higher value wins despite being farther away.
    const snapshot = makeSnapshot({
      player: PLAYER,
      drops: [drop(280, 270, 'spread'), drop(730, 270, 'quantum_core')],
    });

    const brain = createCompetentBotBrain({ content, fallback: null });
    const intent = brain.decide(snapshot, 0.1);
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);
    expect(intent.dirX).toBeGreaterThan(0);

    // With the neutral default value (1) the nearer drop wins instead, so the
    // desirability is genuinely consumed.
    const neutral = createCompetentBotBrain({
      content: EMPTY_BOT_CONTENT,
      fallback: null,
    });
    const neutralIntent = neutral.decide(snapshot, 0.1);
    expect(neutralIntent.dirX).toBeLessThan(0);
  });
});

describe('unknown content degrades gracefully (AC4)', () => {
  it('treats an unknown archetype as a neutral combat target', () => {
    const brain = createCompetentBotBrain({
      content: EMPTY_BOT_CONTENT,
      fallback: null,
    });
    brain.decide(
      makeSnapshot({ player: PLAYER, enemies: [enemy(680, 270, 'mystery')] }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.engageEnemy);
  });

  it('collects an unknown drop like a neutral power-up', () => {
    const brain = createCompetentBotBrain({
      content: EMPTY_BOT_CONTENT,
      fallback: null,
    });
    brain.decide(
      makeSnapshot({ player: PLAYER, drops: [drop(280, 270, 'mystery')] }),
      0.1,
    );
    expect(brain.committedGoalId).toBe(COMPETENT_GOAL_IDS.collectPowerUp);
  });
});
