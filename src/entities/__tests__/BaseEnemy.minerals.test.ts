/**
 * BaseEnemy mineral accounting and re-drop distribution tests
 * (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC3: every non-asteroid
 * enemy that overlaps a mineral absorbs it and tracks a per-enemy mineral
 * count; destroying that enemy re-drops 25–50 % (configurable) of the
 * collected count as individual mineral drops at the explosion site, never
 * exceeding the collected count. Asteroids are excluded from collection.
 *
 * These tests are expected to be red until the implementation child
 * ("Mineral rules tunables and per-enemy mineral count") lands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { BaseEnemy, BaseEnemyConfig } from '../BaseEnemy';
import { Asteroid } from '../Asteroid';
import { Mineral } from '../Mineral';
import type { FormationOffset } from '../../utils/formations';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

/** Minimal concrete BaseEnemy used to exercise the shared mineral API. */
class TestEnemy extends BaseEnemy {
  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // No body needed for the mineral-accounting contract.
  }
}

const OFFSET: FormationOffset = { row: 0, col: 0 };

function makeEnemy(scene: Phaser.Scene, x = 100, y = 100): TestEnemy {
  const config: BaseEnemyConfig = {
    formationOffset: OFFSET,
    size: 16,
    color: 0x00ff00,
  };
  return new TestEnemy(scene, x, y, config);
}

describe('BaseEnemy mineral accounting', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('starts with zero collected minerals', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    expect(enemy.mineralCount).toBe(0);
  });

  it('collectMineral increments the tracked mineral count', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);

    enemy.collectMineral();
    expect(enemy.mineralCount).toBe(1);

    enemy.collectMineral();
    enemy.collectMineral();
    expect(enemy.mineralCount).toBe(3);
  });

  it('mineralRedropCount returns 0 when no minerals were collected', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    expect(enemy.mineralRedropCount(() => 0)).toBe(0);
    expect(enemy.mineralRedropCount(() => 0.999)).toBe(0);
  });

  it('re-drop honours the configured 25-50% fraction at the rng extremes', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    for (let i = 0; i < 4; i++) enemy.collectMineral(); // count = 4

    // floor(4 × 0.25) = 1, floor(4 × 0.5) = 2
    expect(enemy.mineralRedropCount(() => 0)).toBe(1);
    expect(enemy.mineralRedropCount(() => 0.999)).toBe(2);
  });

  it('re-drop stays within [floor(25%), floor(50%)] and never exceeds the count', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    for (let i = 0; i < 100; i++) enemy.collectMineral(); // count = 100

    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const n = enemy.mineralRedropCount();
      expect(n).toBeGreaterThanOrEqual(25);
      expect(n).toBeLessThanOrEqual(50);
      expect(n).toBeLessThanOrEqual(100);
      seen.add(n);
    }
    // The draw is randomised — 1000 draws should produce more than one value.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('re-drop never exceeds the collected count for small counts', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    for (let i = 0; i < 3; i++) enemy.collectMineral(); // count = 3

    for (let i = 0; i < 100; i++) {
      expect(enemy.mineralRedropCount()).toBeLessThanOrEqual(3);
      expect(enemy.mineralRedropCount()).toBeGreaterThanOrEqual(0);
    }
  });

  it('spawnMineralDrops spawns individual Mineral drops at the explosion site', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene, 400, 300);
    for (let i = 0; i < 8; i++) enemy.collectMineral(); // count = 8 → [2, 4]

    const drops = enemy.spawnMineralDrops(400, 300, () => 0.999);

    expect(drops.length).toBe(enemy.mineralRedropCount(() => 0.999));
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      expect(drop).toBeInstanceOf(Mineral);
      // Each drop lands near the explosion site (scattered, not off-screen).
      expect(Math.abs(drop.x - 400)).toBeLessThanOrEqual(100);
      expect(Math.abs(drop.y - 300)).toBeLessThanOrEqual(100);
    }
  });
});

describe('Asteroids are excluded from mineral collection', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('Asteroid.collectMineral is a no-op — mineral count stays 0', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = new Asteroid(booted.scene, {
      x: 100,
      y: 100,
      formationOffset: OFFSET,
      sizeTier: 'small',
    });

    asteroid.collectMineral();
    asteroid.collectMineral();

    expect(asteroid.mineralCount).toBe(0);
  });

  it('Asteroid.mineralRedropCount is always 0', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = new Asteroid(booted.scene, {
      x: 100,
      y: 100,
      formationOffset: OFFSET,
      sizeTier: 'small',
    });

    expect(asteroid.mineralRedropCount(() => 0.5)).toBe(0);
  });
});
