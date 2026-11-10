/**
 * BaseEnemy mineral accounting and re-drop distribution tests
 * (AH-0MUBVGI62004ED9Q, AH-0MULUOZQP009GRWX).
 *
 * Every non-asteroid enemy that overlaps a mineral absorbs it and tracks a
 * per-enemy mineral count; destroying that enemy re-drops twice
 * `round(collected + random bonus)` (`mineralRedropBonusMin`/`Max`,
 * default 0.25–1.25), scattered at the explosion site — the
 * `MINERAL_DROP_MULTIPLIER` doubling from parent AH-0MWB9LCED004K67Y.
 * There is no upper cap, so a kill may return more than the enemy absorbed.
 * Asteroids are excluded from collection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { MINERAL_DROP_MULTIPLIER } from '../../core/constants';
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

  it('collectMineral(value) tallies the absorbed mineral\'s worth (AH-0MVJ79739008396I)', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);

    // A red deposit is worth 10, so absorbing one equals ten ordinary dots —
    // and the enemy's own later re-drop therefore resolves at the threshold.
    enemy.collectMineral(10);
    expect(enemy.mineralCount).toBe(10);
    // Doubled: 2 × round(10 + 0.25) = 20.
    expect(enemy.mineralRedropCount(() => 0)).toBe(
      MINERAL_DROP_MULTIPLIER * Math.round(10 + 0.25),
    );

    enemy.collectMineral();
    expect(enemy.mineralCount).toBe(11);
  });

  it('mineralRedropCount at rng extremes when no minerals were collected', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    // rng() = 0 → 2 × round(0 + 0.25) = 0; rng() ≈ 1 → 2 × round(0 + 1.25) = 2.
    // So an empty enemy drops nothing most of the time but may occasionally
    // drop two minerals (never one — the bonus roll is doubled).
    expect(enemy.mineralRedropCount(() => 0)).toBe(0);
    expect(enemy.mineralRedropCount(() => 0.999)).toBe(2);
  });

  it('re-drop returns 2 × round(collected + random(0.25, 1.25)) at the rng extremes', async () => {
    booted = await bootScene([HarnessScene]);
    for (const collected of [1, 2, 3, 5, 10]) {
      const enemy = makeEnemy(booted.scene);
      for (let i = 0; i < collected; i++) enemy.collectMineral();

      // rng() = 0 → 2 × round(N + 0.25); rng() = 1 → 2 × round(N + 1.25).
      expect(enemy.mineralRedropCount(() => 0)).toBe(
        MINERAL_DROP_MULTIPLIER * Math.round(collected + 0.25),
      );
      expect(enemy.mineralRedropCount(() => 1)).toBe(
        MINERAL_DROP_MULTIPLIER * Math.round(collected + 1.25),
      );
    }
  });

  it('draws exactly one additive bonus value per call', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    for (let i = 0; i < 4; i++) enemy.collectMineral(); // count = 4

    let draws = 0;
    const rng = () => {
      draws += 1;
      return 0.5;
    };
    const value = enemy.mineralRedropCount(rng);

    expect(draws).toBe(1);
    // Bonus = 0.25 + 0.5 × (1.25 − 0.25) = 0.75 → 2 × round(4.75) = 10.
    expect(value).toBe(10);
  });

  it('has no upper cap — a kill may return more than the enemy absorbed', async () => {
    booted = await bootScene([HarnessScene]);
    for (const collected of [1, 2]) {
      const enemy = makeEnemy(booted.scene);
      for (let i = 0; i < collected; i++) enemy.collectMineral();

      const low = enemy.mineralRedropCount(() => 0);
      const high = enemy.mineralRedropCount(() => 1);
      expect(low).toBe(MINERAL_DROP_MULTIPLIER * Math.round(collected + 0.25));
      expect(high).toBe(MINERAL_DROP_MULTIPLIER * Math.round(collected + 1.25));
      expect(high).toBeGreaterThan(collected);
    }
  });

  it('stays within the doubled bonus bounds over many draws', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    for (let i = 0; i < 100; i++) enemy.collectMineral(); // count = 100

    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const n = enemy.mineralRedropCount();
      // 2 × round(100 + 0.25) = 200 … 2 × round(100 + 1.25) = 202.
      expect(n).toBeGreaterThanOrEqual(MINERAL_DROP_MULTIPLIER * 100);
      expect(n).toBeLessThanOrEqual(MINERAL_DROP_MULTIPLIER * 101);
      seen.add(n);
    }
    // The bonus is randomised — 1000 draws should produce both endpoints.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('spawnMineralDrops spawns individual Mineral drops at the explosion site', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene, 400, 300);
    for (let i = 0; i < 8; i++) enemy.collectMineral(); // count = 8

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
