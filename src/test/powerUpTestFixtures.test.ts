/**
 * Smoke tests for the shared power-up test fixtures
 * (parent AH-0MU3VOQKH005YOBH, feature AH-0MU44M8EI000CPB0).
 *
 * Every fixture exported by `powerUpTestFixtures.ts` is exercised here so
 * the test infrastructure itself is covered before the downstream items
 * depend on it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  bodiesOverlap,
  bootCombatGymBoss,
  bootCombatGymEnemies,
  createSeededRng,
  createSeededWeightedSpawner,
  createSequenceRng,
  createStubCombatPositions,
  isClearOfBodies,
  stubBody,
} from './powerUpTestFixtures';
import { GYM_ENEMIES_DEFAULT_KEY } from '../scenes/gym/GymEnemies';
import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';

describe('powerUpTestFixtures — deterministic test infrastructure', () => {
  const games: Phaser.Game[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.destroy(true);
  });

  // ── Seeded / scripted RNG ─────────────────────────────────────────

  describe('createSeededRng', () => {
    it('produces the same sequence for the same seed', () => {
      const a = createSeededRng(1234);
      const b = createSeededRng(1234);
      expect(Array.from({ length: 5 }, () => a())).toEqual(
        Array.from({ length: 5 }, () => b()),
      );
    });

    it('produces different sequences for different seeds', () => {
      const a = createSeededRng(1);
      const b = createSeededRng(2);
      expect(Array.from({ length: 5 }, () => a())).not.toEqual(
        Array.from({ length: 5 }, () => b()),
      );
    });

    it('yields values in the half-open interval [0, 1)', () => {
      const rng = createSeededRng(42);
      for (let i = 0; i < 100; i += 1) {
        const value = rng();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });
  });

  describe('createSequenceRng', () => {
    it('returns scripted values in order then repeats the final value', () => {
      const rng = createSequenceRng([0.1, 0.5, 0.9]);
      expect([rng(), rng(), rng(), rng()]).toEqual([0.1, 0.5, 0.9, 0.9]);
    });

    it('yields 0 for an empty script', () => {
      expect(createSequenceRng([])()).toBe(0);
    });
  });

  describe('createSeededWeightedSpawner', () => {
    it('is reproducible across identical spawners', () => {
      const a = createSeededWeightedSpawner(7, ['P3', 'P4', 'P6', 'P7']);
      const b = createSeededWeightedSpawner(7, ['P3', 'P4', 'P6', 'P7']);
      expect(Array.from({ length: 8 }, () => a.next())).toEqual(
        Array.from({ length: 8 }, () => b.next()),
      );
    });

    it('never selects a zero-weight ID', () => {
      const spawner = createSeededWeightedSpawner(3, ['P3', 'P8'], {
        P3: 1,
        P8: 0,
      });
      for (let i = 0; i < 20; i += 1) {
        expect(spawner.next()).toBe('P3');
      }
    });
  });

  // ── Stub enemy/player positions ───────────────────────────────────

  describe('stub combat positions', () => {
    it('stubBody stores its centre and radius', () => {
      expect(stubBody(10, 20, 5)).toEqual({ x: 10, y: 20, radius: 5 });
    });

    it('createStubCombatPositions provides defaults and applies overrides', () => {
      const defaults = createStubCombatPositions();
      expect(defaults.enemies).toEqual([]);
      expect(defaults.player.radius).toBeGreaterThan(0);

      const enemy = stubBody(100, 100, 10);
      const custom = createStubCombatPositions({
        enemies: [enemy],
        player: stubBody(0, 0, 4),
      });
      expect(custom.enemies).toEqual([enemy]);
      expect(custom.player).toEqual({ x: 0, y: 0, radius: 4 });
    });

    it('bodiesOverlap is true only when the circles intersect', () => {
      expect(bodiesOverlap(stubBody(0, 0, 10), stubBody(5, 0, 10))).toBe(true);
      expect(bodiesOverlap(stubBody(0, 0, 10), stubBody(25, 0, 10))).toBe(false);
    });

    it('isClearOfBodies rejects an overlapping candidate and accepts a free one', () => {
      const bodies = [stubBody(0, 0, 10), stubBody(100, 100, 10)];
      expect(isClearOfBodies(stubBody(5, 0, 5), bodies)).toBe(false);
      expect(isClearOfBodies(stubBody(50, 50, 5), bodies)).toBe(true);
    });
  });

  // ── Combat-gym boot helpers ───────────────────────────────────────

  describe('combat-gym boot helpers', () => {
    it('boots GymEnemies with the default key, its formation and a player', async () => {
      const { game, scene } = await bootCombatGymEnemies();
      games.push(game);

      expect(scene.sys.isActive()).toBe(true);
      expect(scene.activeEnemyKey).toBe(GYM_ENEMIES_DEFAULT_KEY);
      expect(scene.formationEntities.length).toBe(
        DEFAULT_ENEMY_CONFIGS[GYM_ENEMIES_DEFAULT_KEY].count,
      );
      expect(scene.getPlayer()).not.toBeNull();
    });

    it('boots GymEnemies with an explicit enemy key', async () => {
      const { game, scene } = await bootCombatGymEnemies('tank');
      games.push(game);

      expect(scene.activeEnemyKey).toBe('tank');
      expect(scene.formationEntities.length).toBe(
        DEFAULT_ENEMY_CONFIGS.tank.count,
      );
    });

    it('boots GymBoss with a single live boss', async () => {
      const { game, scene } = await bootCombatGymBoss();
      games.push(game);

      expect(scene.sys.isActive()).toBe(true);
      expect(scene.formationBoss).toBeDefined();
      expect(scene.formationBoss.alive).toBe(true);
      expect(scene.aliveCount).toBe(1);
    });
  });
});
