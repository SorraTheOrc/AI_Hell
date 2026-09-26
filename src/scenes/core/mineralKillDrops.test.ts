/**
 * Shared mineral kill-drop rule tests (parent AH-0MUHMT5JC004WRSB, AC3/AC5).
 *
 * Pins the single shared rule consumed by `PlayScene` and
 * `GymFormationScene`: a small asteroid drops exactly one mineral at its
 * death site, large/medium asteroids drop none (their split children drop),
 * and a non-asteroid enemy re-drops the configured 25–50 % fraction of the
 * minerals it absorbed, scattered near the death site.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { createSeededRng } from '../../test/powerUpTestFixtures';
import { Asteroid } from '../../entities/Asteroid';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { Mineral } from '../../entities/Mineral';
import { MINERAL_REDROP_SCATTER_RADIUS } from '../../core/constants';
import type { FormationOffset } from '../../utils/formations';
import { resolveMineralKillDrops } from './mineralKillDrops';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('MineralKillDropsHarness');
  }
}

/** Minimal concrete BaseEnemy used to exercise the shared mineral API. */
class TestEnemy extends BaseEnemy {
  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // No body needed for the kill-drop contract.
  }
}

const OFFSET: FormationOffset = { row: 0, col: 0 };

function makeEnemy(scene: Phaser.Scene, x: number, y: number): TestEnemy {
  const config: BaseEnemyConfig = {
    formationOffset: OFFSET,
    size: 16,
    color: 0x00ff00,
  };
  return new TestEnemy(scene, x, y, config);
}

function makeAsteroid(
  scene: Phaser.Scene,
  x: number,
  y: number,
  sizeTier: 'large' | 'medium' | 'small',
): Asteroid {
  return new Asteroid(scene, { x, y, formationOffset: OFFSET, sizeTier });
}

describe('resolveMineralKillDrops — asteroid rule', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('a small asteroid drops exactly one mineral at its death position', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const asteroid = makeAsteroid(scene, 321, 234, 'small');

    const drops = resolveMineralKillDrops(scene, asteroid, () => 0.5);

    expect(drops).toHaveLength(1);
    expect(drops[0]).toBeInstanceOf(Mineral);
    expect(drops[0].x).toBe(321);
    expect(drops[0].y).toBe(234);
  });

  it('medium and large asteroids do not drop directly', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    for (const tier of ['medium', 'large'] as const) {
      const asteroid = makeAsteroid(scene, 400, 300, tier);
      expect(resolveMineralKillDrops(scene, asteroid, () => 0.5)).toEqual([]);
    }
  });
});

describe('resolveMineralKillDrops — non-asteroid re-drop rule', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('re-drops between the configured fractions, never more than collected, at the death site', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 500, 250);
    for (let i = 0; i < 100; i += 1) enemy.collectMineral();

    // Low extreme: rng() === 0 → floor(100 × 0.25) = 25, scatter radius 0.
    const low = resolveMineralKillDrops(scene, enemy, () => 0);
    expect(low).toHaveLength(25);
    for (const drop of low) {
      expect(drop.x).toBe(500);
      expect(drop.y).toBe(250);
    }

    // High extreme: rng() === 0.999 → floor(100 × 0.5) = 50.
    const high = resolveMineralKillDrops(scene, enemy, () => 0.999);
    expect(high).toHaveLength(50);
  });

  it('re-drops nothing when the enemy absorbed nothing', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 100, 100);

    expect(resolveMineralKillDrops(scene, enemy, () => 0.999)).toEqual([]);
  });

  it('scatters every drop within the configured re-drop radius', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 300, 300);
    for (let i = 0; i < 100; i += 1) enemy.collectMineral();

    const drops = resolveMineralKillDrops(scene, enemy, createSeededRng(42));
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      expect(
        Math.hypot(drop.x - 300, drop.y - 300),
      ).toBeLessThanOrEqual(MINERAL_REDROP_SCATTER_RADIUS);
    }
  });

  it('is deterministic for a given seed', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 300, 300);
    for (let i = 0; i < 40; i += 1) enemy.collectMineral();

    const first = resolveMineralKillDrops(scene, enemy, createSeededRng(7));
    const second = resolveMineralKillDrops(scene, enemy, createSeededRng(7));

    expect(second.map((m) => [m.x, m.y])).toEqual(
      first.map((m) => [m.x, m.y]),
    );
  });

  it('returns no drops for an entity with no mineral hooks', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const plain = scene.add.container(10, 10);

    expect(resolveMineralKillDrops(scene, plain, () => 0.5)).toEqual([]);
  });
});

describe('resolveMineralKillDrops — scatter parity with BaseEnemy.spawnMineralDrops', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('produces identical drop positions for the same seed (one shared scatter body)', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 450, 220);
    for (let i = 0; i < 60; i += 1) enemy.collectMineral();

    const viaRule = resolveMineralKillDrops(scene, enemy, createSeededRng(99));
    const viaEnemy = enemy.spawnMineralDrops(450, 220, createSeededRng(99));

    expect(viaRule.map((m) => [m.x, m.y])).toEqual(
      viaEnemy.map((m) => [m.x, m.y]),
    );
  });
});
