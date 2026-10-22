/**
 * Smoke tests for the shared collector-drone fixtures
 * (parent AH-0MV9G113S009B37I, leading task AH-0MVBMPYPB004RP0P).
 *
 * Every fixture exported by `collectorDroneFixtures.ts` is exercised here so
 * the test infrastructure is covered before the downstream drone items
 * (level variables, entity, lifecycle pass, spawn wiring, gym parity)
 * depend on it. The parent-AC → test matrix lives in the fixture file
 * header (see `collectorDroneFixtures.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { PowerUpState } from '../powerups/PowerUp';
import { collectOverlappingDrops } from '../scenes/core/dropLayer';
import {
  COLLECTOR_DRONE_MINERAL_CLEARANCE,
  bootCollectorDroneScene,
  createMysteryUfoDrop,
  createSeededMineralField,
  createSteppedClock,
  isClearOf,
  makeDropCollectible,
  resolveSeededMineralPositions,
  type SteppedClock,
  DEFAULT_MINERAL_FIELD_BOUNDS,
} from './collectorDroneFixtures';
import { PLAYER_SPAWN, MINERAL_SIZE } from '../core/constants';

describe('collectorDroneFixtures — shared collector-drone test infrastructure', () => {
  const games: Phaser.Game[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.destroy(true);
  });

  // ── Seeded mineral-field builder ──────────────────────────────────

  describe('resolveSeededMineralPositions', () => {
    it('is deterministic for a fixed seed', () => {
      const a = resolveSeededMineralPositions({ count: 8, seed: 7 });
      const b = resolveSeededMineralPositions({ count: 8, seed: 7 });
      expect(a).toEqual(b);
      expect(a).toHaveLength(8);
    });

    it('produces different fields for different seeds (seeded RNG)', () => {
      const a = resolveSeededMineralPositions({ count: 8, seed: 1 });
      const b = resolveSeededMineralPositions({ count: 8, seed: 2 });
      expect(a).not.toEqual(b);
    });

    it('places every mineral clear of the ship start by default', () => {
      const positions = resolveSeededMineralPositions({ count: 16, seed: 3 });
      for (const position of positions) {
        expect(isClearOf(position, PLAYER_SPAWN)).toBe(true);
        const distance = Math.hypot(
          position.x - PLAYER_SPAWN.x,
          position.y - PLAYER_SPAWN.y,
        );
        expect(distance).toBeGreaterThanOrEqual(
          COLLECTOR_DRONE_MINERAL_CLEARANCE,
        );
      }
    });

    it('honours an explicit clearance and clearOf point', () => {
      const clearOf = { x: 100, y: 100 };
      const positions = resolveSeededMineralPositions({
        count: 10,
        seed: 5,
        clearOf,
        clearance: 30,
      });
      for (const position of positions) {
        expect(Math.hypot(position.x - 100, position.y - 100)).toBeGreaterThanOrEqual(30);
      }
    });

    it('stays inside the default play-area bounds (HUD margin respected)', () => {
      const positions = resolveSeededMineralPositions({ count: 20, seed: 9 });
      for (const position of positions) {
        expect(position.x).toBeGreaterThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.minX);
        expect(position.x).toBeLessThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.maxX);
        expect(position.y).toBeGreaterThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.minY);
        expect(position.y).toBeLessThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.maxY);
      }
    });

    it('an empty count yields no positions', () => {
      expect(resolveSeededMineralPositions({ count: 0 })).toHaveLength(0);
    });
  });

  describe('createSeededMineralField', () => {
    it('creates live Mineral entities at the seeded positions', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const minerals = createSeededMineralField(scene, { count: 5, seed: 11 });
      const positions = resolveSeededMineralPositions({ count: 5, seed: 11 });

      expect(minerals).toHaveLength(5);
      for (let i = 0; i < minerals.length; i += 1) {
        expect(minerals[i].alive).toBe(true);
        expect(minerals[i].x).toBeCloseTo(positions[i].x, 5);
        expect(minerals[i].y).toBeCloseTo(positions[i].y, 5);
        // Not overlapping the ship start: outside the ship's pickup radius.
        const distance = Math.hypot(
          minerals[i].x - PLAYER_SPAWN.x,
          minerals[i].y - PLAYER_SPAWN.y,
        );
        expect(distance).toBeGreaterThan(MINERAL_SIZE + 10);
      }
    });
  });

  // ── Stepped / mock clock ──────────────────────────────────────────

  describe('createSteppedClock', () => {
    it('starts at zero and advances deterministically', () => {
      const clock = createSteppedClock();
      expect(clock.now()).toBe(0);
      expect(clock.advance(0.5)).toBe(0.5);
      expect(clock.now()).toBe(0.5);
    });

    it('step() advances one fixed frame at a time', () => {
      const clock = createSteppedClock(1 / 60);
      expect(clock.step()).toBeCloseTo(1 / 60, 5);
      expect(clock.now()).toBeCloseTo(1 / 60, 5);
      clock.step();
      expect(clock.now()).toBeCloseTo(2 / 60, 5);
    });

    it('run() ticks the callback once per fixed step until the elapsed time', () => {
      const clock = createSteppedClock(1 / 60);
      const ticks: number[] = [];
      const end = clock.run(30, (now) => ticks.push(now));
      // 30 s of 1/60 steps (default ceil) — the permanent-timer cadence.
      expect(ticks.length).toBe(1800);
      expect(ticks[0]).toBeCloseTo(1 / 60, 5);
      expect(end).toBeCloseTo(30, 5);
      expect(clock.now()).toBeCloseTo(30, 5);
    });

    it('reset() returns the clock to zero', () => {
      const clock = createSteppedClock();
      clock.advance(10);
      clock.reset();
      expect(clock.now()).toBe(0);
    });

    it('is a driven time source: explicit advances only (no wall clock)', () => {
      const clock: SteppedClock = createSteppedClock();
      expect(clock.now()).toBe(0); // nothing moves until advanced
    });
  });

  // ── Mystery UFO drop manufacture ──────────────────────────────────

  describe('createMysteryUfoDrop', () => {
    it('manufactures a mystery_ufo drop at the requested position', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const drop = createMysteryUfoDrop(scene, 200, 150);

      expect(drop.x).toBe(200);
      expect(drop.y).toBe(150);
      expect(drop.dropId).toBe('mystery_ufo');
      expect(drop.powerUp.id).toBe('mystery_ufo');
      expect(drop.graphics).toBeDefined();
      expect(drop.powerUp.state).toBe(PowerUpState.GROWING); // starts at scale 0
    });

    it('makeDropCollectible matures the drop so the shared gate collects it', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const drop = makeDropCollectible(createMysteryUfoDrop(scene, 200, 150));
      const collected: typeof drop[] = [];
      const kept = collectOverlappingDrops(
        [drop],
        { x: 200, y: 150 },
        (d) => {
          d.absorbing = true;
          collected.push(d);
        },
      );

      expect(drop.powerUp.canCollect()).toBe(true);
      expect(collected).toEqual([drop]);
      expect(kept).toEqual([]); // collected → removed from the field
    });

    it('an immature drop is not collectible through the shared gate', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const drop = createMysteryUfoDrop(scene, 200, 150);
      const collected: typeof drop[] = [];
      collectOverlappingDrops(
        [drop],
        { x: 200, y: 150 },
        (d) => {
          d.absorbing = true;
          collected.push(d);
        },
      );

      expect(drop.powerUp.canCollect()).toBe(false);
      expect(collected).toEqual([]);
    });
  });
});
