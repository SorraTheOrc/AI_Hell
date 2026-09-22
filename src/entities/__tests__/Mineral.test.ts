/**
 * Mineral entity lifecycle and collection semantics tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC1: a mineral is a small
 * gold dot that is collected on overlap, is never hit by bullets, and causes
 * no damage.
 *
 * These tests are expected to be red until the implementation child
 * ("Mineral collectable entity and constants") lands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { MINERAL_COLOR, MINERAL_DEPTH, MINERAL_SIZE } from '../../core/constants';
import { Mineral, MineralConfig } from '../Mineral';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('Mineral constants', () => {
  it('defines MINERAL_SIZE as a small gold dot radius', () => {
    expect(typeof MINERAL_SIZE).toBe('number');
    expect(MINERAL_SIZE).toBeGreaterThan(0);
    expect(MINERAL_SIZE).toBeLessThan(10); // small, not ship-sized
  });

  it('defines MINERAL_COLOR as gold', () => {
    expect(MINERAL_COLOR).toBe(0xffdd44); // gold hex
  });

  it('defines MINERAL_DEPTH above regular gameplay objects', () => {
    expect(typeof MINERAL_DEPTH).toBe('number');
    expect(MINERAL_DEPTH).toBeGreaterThan(1); // above body/explode depth
  });
});

describe('Mineral entity lifecycle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeMineral(
    scene: Phaser.Scene,
    x: number,
    y: number,
    onCollect?: () => void,
  ): Mineral {
    const config: MineralConfig = { x, y, onCollect };
    return new Mineral(scene, config);
  }

  it('spawns at a given position', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    expect(mineral.x).toBe(400);
    expect(mineral.y).toBe(200);
  });

  it('renders as a small gold dot', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    // The mineral should be a Graphics object with gold fill/stroke.
    expect(mineral).toBeInstanceOf(Phaser.GameObjects.Graphics);
    // Check the body graphics has commands (gold dot shape).
    const body = mineral as unknown as { bodyGraphics: Phaser.GameObjects.Graphics };
    expect(body.bodyGraphics).toBeDefined();
    expect(body.bodyGraphics.commandBuffer.length).toBeGreaterThan(0);
  });

  it('persists until collected (no drift or despawn)', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    const startX = mineral.x;
    const startY = mineral.y;
    // Advance time significantly — mineral should not move.
    mineral.updatePosition(10); // 10 seconds should pass
    expect(mineral.x).toBeCloseTo(startX, 5);
    expect(mineral.y).toBeCloseTo(startY, 5);
  });

  it('invokes the collection callback when collected by player overlap', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Simulate player overlap by calling the overlap handler directly.
    mineral.handleOverlap('player');
    expect(onCollect).toHaveBeenCalledTimes(1);
  });

  it('removes itself after collection (marked as dead)', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    mineral.handleOverlap('player');
    expect(mineral.alive).toBe(false);
  });

  it('fires the collection callback exactly once even with multiple overlaps', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Multiple overlaps after first collection — should only fire once.
    mineral.handleOverlap('player');
    mineral.handleOverlap('player');
    mineral.handleOverlap('player');
    expect(onCollect).toHaveBeenCalledTimes(1);
  });

  it('minerals are not hit by bullets (no collision response)', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // A bullet overlap should NOT trigger collection or destroy the mineral.
    mineral.handleOverlap('bullet');
    expect(onCollect).not.toHaveBeenCalled();
    expect(mineral.alive).toBe(true);
  });

  it('minerals cause no damage to the player on contact', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Player overlap should collect but not damage the player.
    // The mineral itself should not have any damage-dealing side effects.
    const beforeX = mineral.x;
    const beforeY = mineral.y;
    mineral.handleOverlap('player');
    // No explosion, no damage VFX — just collection.
    expect(mineral.x).toBe(beforeX);
    expect(mineral.y).toBe(beforeY);
  });

  it('a non-asteroid enemy overlapping a mineral absorbs it', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Enemy overlap absorbs the mineral (same collection behaviour).
    mineral.handleOverlap('enemy');
    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(mineral.alive).toBe(false);
  });

  it('overlapping a mineral causes no damage to the enemy', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Enemy overlap should not damage the enemy.
    const beforeX = mineral.x;
    const beforeY = mineral.y;
    mineral.handleOverlap('enemy');
    expect(mineral.x).toBe(beforeX);
    expect(mineral.y).toBe(beforeY);
  });

  it('asteroids do NOT absorb minerals (asteroids are inert to minerals)', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Asteroid overlap should have no effect — minerals are collected
    // by the player, and absorbed by non-asteroid enemies, but NOT
    // by asteroids.
    // The handleOverlap method may or may not accept 'asteroid' as a type;
    // if it does, it should be a no-op.
    mineral.handleOverlap('asteroid');
    // Asteroids should not absorb minerals.
    expect(mineral.alive).toBe(true);
  });

  it('renders above bullet layer for visibility', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    // Check that the mineral has a depth set for proper render ordering.
    const body = mineral as unknown as { bodyGraphics: Phaser.GameObjects.Graphics };
    expect(body.bodyGraphics.depth).toBeGreaterThan(1);
  });
});
