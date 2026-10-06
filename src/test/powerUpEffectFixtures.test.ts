/**
 * Smoke tests for the shared P3/P4 effect-path fixtures
 * (parent AH-0MUVM9RAO004Y3LB, feature AH-0MUWGCZP6009MF3L).
 *
 * Every fixture exported by `powerUpEffectFixtures.ts` is exercised here so
 * the test infrastructure is covered before the downstream multi-hit shield
 * (F2), bomb model (F3) and ranged-pulse (F4) items depend on it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  activateEffectAtUpgradeLevel,
  bootRangedClearScene,
  createEffectRegistry,
  createSeededLevelStore,
  expectRangedClear,
  isWithinBlastRange,
  partitionByBlastRange,
  seedUpgradeLevel,
} from './powerUpEffectFixtures';
import { resolvePowerUpAtLevel } from '../powerups/powerUpLevels';

describe('powerUpEffectFixtures — shared P3/P4 test infrastructure', () => {
  const games: Phaser.Game[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.destroy(true);
  });

  // ── Level-store fixtures ──────────────────────────────────────────

  describe('createSeededLevelStore / seedUpgradeLevel', () => {
    it('seeds the requested upgrade level (0 = one collection = base)', () => {
      const store = createSeededLevelStore({ P3: 2, P4: 0 });
      expect(store.getUpgradeLevel('P3')).toBe(2);
      expect(store.getUpgradeLevel('P4')).toBe(0);
      expect(store.getLevel('P3')).toBe(3); // collections = upgrades + 1
      expect(store.stats('P3')).toEqual(resolvePowerUpAtLevel('P3', 2));
      // Unlisted power-ups stay untouched.
      expect(store.getLevel('P5')).toBe(0);
    });

    it('is idempotent and clamps negative/fractional levels', () => {
      const store = createSeededLevelStore();
      seedUpgradeLevel(store, 'P4', 1.9);
      expect(store.getUpgradeLevel('P4')).toBe(1);
      seedUpgradeLevel(store, 'P4', 1); // no further collections
      expect(store.getLevel('P4')).toBe(2);
      seedUpgradeLevel(store, 'P4', -5);
      expect(store.getUpgradeLevel('P4')).toBe(1);
    });
  });

  describe('createEffectRegistry', () => {
    it('binds the registry to the returned store', () => {
      const { registry, store } = createEffectRegistry();
      registry.applyCollect('P5');
      expect(store.getLevel('P5')).toBe(1);
    });

    it('pre-seeds levels without activating a timed effect', () => {
      const { registry, store } = createEffectRegistry({ P3: 1 });
      expect(store.getUpgradeLevel('P3')).toBe(1);
      expect(registry.isShielded).toBe(false); // seeding is store-only
    });
  });

  describe('activateEffectAtUpgradeLevel', () => {
    it('activates P3 at the requested upgrade level and resolves its stats', () => {
      const fixture = createEffectRegistry();
      const stats = activateEffectAtUpgradeLevel(fixture, 'P3', 2);

      expect(fixture.registry.isShielded).toBe(true);
      expect(fixture.store.getUpgradeLevel('P3')).toBe(2);
      expect(stats).toEqual(resolvePowerUpAtLevel('P3', 2));
    });

    it('activates the permanent (hold-full) form when requested', () => {
      const fixture = createEffectRegistry();
      activateEffectAtUpgradeLevel(fixture, 'P4', 1, { permanent: true });

      expect(fixture.store.getUpgradeLevel('P4')).toBe(1);
      expect(fixture.store.permanentGrants('P4')).toBe(1);
    });
  });

  // ── Ranged-clear oracle ───────────────────────────────────────────

  describe('isWithinBlastRange / partitionByBlastRange', () => {
    it('treats the boundary as inclusive', () => {
      expect(isWithinBlastRange(10, 0, 0, 0, 10)).toBe(true);
      expect(isWithinBlastRange(10.0001, 0, 0, 0, 10)).toBe(false);
      expect(isWithinBlastRange(0, 0, 0, 0, 0)).toBe(true);
    });

    it('partitions bullets into cleared and spared sets', () => {
      const bullets = [
        { x: 0, y: 0 },
        { x: 3, y: 4 }, // distance 5 → inside
        { x: 100, y: 0 }, // outside
      ];
      const { cleared, spared } = partitionByBlastRange(bullets, 0, 0, 5);
      expect(cleared).toEqual([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
      expect(spared).toEqual([{ x: 100, y: 0 }]);
    });
  });

  describe('expectRangedClear', () => {
    it('passes when the clear matches the oracle exactly', () => {
      expect(() =>
        expectRangedClear(
          [
            { x: 0, y: 0, destroyed: true }, // inside → destroyed
            { x: 100, y: 0, destroyed: false }, // outside → spared
          ],
          0,
          0,
          10,
        ),
      ).not.toThrow();
    });

    it('fails when an in-range bullet survived or an out-of-range bullet was destroyed', () => {
      expect(() =>
        expectRangedClear([{ x: 0, y: 0, destroyed: false }], 0, 0, 10),
      ).toThrow(/should have been destroyed/);
      expect(() =>
        expectRangedClear([{ x: 100, y: 0, destroyed: true }], 0, 0, 10),
      ).toThrow(/should have been spared/);
    });
  });

  // ── Bullet-field scene fixture ────────────────────────────────────

  describe('RangedClearTestScene', () => {
    it('boots with an empty bullet field', async () => {
      const booted = await bootRangedClearScene();
      games.push(booted.game);
      expect(booted.scene.sys.isActive()).toBe(true);
      expect(booted.scene.createdBullets()).toHaveLength(0);
      expect(booted.scene.survivingBullets()).toHaveLength(0);
    });

    it('tracks created/destroyed/surviving bullets across a shared clear', async () => {
      const { game, scene } = await bootRangedClearScene();
      games.push(game);
      scene.addEnemyBullet(100, 100);
      scene.addEnemyBullet(200, 100);
      scene.addEnemyBullet(300, 100);
      expect(scene.createdBullets()).toHaveLength(3);
      expect(scene.survivingBullets()).toHaveLength(3);

      scene.runClearEnemyBullets();

      expect(scene.survivingBullets()).toHaveLength(0);
      expect(scene.destroyedBullets()).toHaveLength(3);
      for (const bullet of scene.createdBullets()) {
        expect(bullet.destroyed).toBe(true);
      }
    });

    it('integrates with expectRangedClear for a covering blast', async () => {
      const { game, scene } = await bootRangedClearScene();
      games.push(game);
      scene.addEnemyBullet(100, 100);
      scene.addEnemyBullet(300, 100);
      scene.runClearEnemyBullets();

      // A blast large enough to cover every bullet is consistent with the
      // whole-field clear the fixture just performed.
      expect(() =>
        expectRangedClear(scene.createdBullets(), 200, 100, 1000),
      ).not.toThrow();
      // A blast that should have spared the outer bullets contradicts the
      // observed clear — proving the assertion is not vacuous.
      expect(() =>
        expectRangedClear(scene.createdBullets(), 200, 100, 10),
      ).toThrow();
    });
  });
});
