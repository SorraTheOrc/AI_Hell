/**
 * Shared mineral kill-drop rule tests (parent AH-0MUHMT5JC004WRSB, AC3/AC5).
 *
 * Pins the single shared rule consumed by `PlayScene` and
 * `GymFormationScene`: a small asteroid drops exactly one mineral at its
 * death site, large/medium asteroids drop none (their split children drop),
 * and a non-asteroid enemy re-drops its collected minerals plus a random
 * additive bonus (default 0.25–1.25), rounded to the nearest integer and
 * scattered near the death site.
 *
 * Also pins the Salvage bounty seam (`scatterSalvageMineralDrops`,
 * AH-0MVJ72I8O0009T09): the same scatter maths and RNG draw order, but the
 * drops render orange so the bounty is visible on the field.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { createSeededRng } from '../../test/powerUpTestFixtures';
import { Asteroid } from '../../entities/Asteroid';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { Mineral } from '../../entities/Mineral';
import {
  MINERAL_COLOR,
  MINERAL_REDROP_SCATTER_RADIUS,
  MINERAL_SALVAGE_COLOR,
} from '../../core/constants';
import type { FormationOffset } from '../../utils/formations';
import {
  resolveMineralKillDrops,
  scatterSalvageMineralDrops,
} from './mineralKillDrops';

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

  it('re-drops the collected count plus an additive bonus at the death site', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 500, 250);
    for (let i = 0; i < 100; i += 1) enemy.collectMineral();

    // Low extreme: rng() === 0 → round(100 + 0.25) = 100, scatter radius 0.
    const low = resolveMineralKillDrops(scene, enemy, () => 0);
    expect(low).toHaveLength(100);
    for (const drop of low) {
      expect(drop.x).toBe(500);
      expect(drop.y).toBe(250);
    }

    // High extreme: rng() === 0.999 → round(100 + 0.25 + 0.999) = 101.
    const high = resolveMineralKillDrops(scene, enemy, () => 0.999);
    expect(high).toHaveLength(101);
  });

  it('an enemy that absorbed nothing may occasionally drop one mineral', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const enemy = makeEnemy(scene, 100, 100);

    // rng() = 0 → round(0.25) = 0 (no drop); rng() = 0.999 → round(1.249) = 1.
    expect(resolveMineralKillDrops(scene, enemy, () => 0)).toEqual([]);
    const drop = resolveMineralKillDrops(scene, enemy, () => 0.999);
    expect(drop).toHaveLength(1);
    // The drop is scattered within the configured radius.
    expect(
      Math.hypot(drop[0].x - 100, drop[0].y - 100),
    ).toBeLessThanOrEqual(MINERAL_REDROP_SCATTER_RADIUS);
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

describe('scatterSalvageMineralDrops — orange Salvage bounty seam (AH-0MVJ72I8O0009T09)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns the requested number of orange minerals at the wreck', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    const drops = scatterSalvageMineralDrops(scene, 400, 300, 4, () => 0);

    expect(drops).toHaveLength(4);
    expect(drops.every((d) => d instanceof Mineral)).toBe(true);
    // rng() = 0 → zero scatter radius, so every drop lands on the wreck.
    for (const drop of drops) {
      expect(drop.color).toBe(MINERAL_SALVAGE_COLOR);
      expect(drop.x).toBe(400);
      expect(drop.y).toBe(300);
    }
  });

  it('scatters within the shared re-drop radius, like an ordinary drop', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    const drops = scatterSalvageMineralDrops(
      scene,
      300,
      300,
      12,
      createSeededRng(11),
    );

    expect(drops).toHaveLength(12);
    for (const drop of drops) {
      expect(
        Math.hypot(drop.x - 300, drop.y - 300),
      ).toBeLessThanOrEqual(MINERAL_REDROP_SCATTER_RADIUS);
    }
  });

  it('returns no drops for a zero or negative bounty', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    expect(scatterSalvageMineralDrops(scene, 100, 100, 0)).toEqual([]);
    expect(scatterSalvageMineralDrops(scene, 100, 100, -2)).toEqual([]);
  });

  it('consumes the same RNG draws in the same order as a gold scatter', async () => {
    // Parity guarantee (AC4): adding the colour must not reorder or add
    // draws, so a seeded run yields the same positions as an equivalent
    // gold scatter loop over the same seed.
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    const orange = scatterSalvageMineralDrops(
      scene,
      250,
      180,
      6,
      createSeededRng(99),
    );
    const goldRng = createSeededRng(99);
    const gold = Array.from({ length: 6 }, () => {
      const angle = goldRng() * Math.PI * 2;
      const radius = goldRng() * MINERAL_REDROP_SCATTER_RADIUS;
      return [250 + Math.cos(angle) * radius, 180 + Math.sin(angle) * radius];
    });

    expect(orange.map((m) => [m.x, m.y])).toEqual(gold);
    // …while the salvage drops themselves are orange, not gold.
    expect(orange.every((m) => m.color === MINERAL_SALVAGE_COLOR)).toBe(true);
  });

  it('leaves the ordinary kill-drop rule gold (baseline economy readable)', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;

    const asteroidDrops = resolveMineralKillDrops(
      scene,
      makeAsteroid(scene, 120, 90, 'small'),
      () => 0.5,
    );
    expect(asteroidDrops).toHaveLength(1);
    expect(asteroidDrops[0].color).toBe(MINERAL_COLOR);

    const enemy = makeEnemy(scene, 500, 250);
    for (let i = 0; i < 20; i += 1) enemy.collectMineral();
    const redrops = resolveMineralKillDrops(scene, enemy, createSeededRng(3));
    expect(redrops.length).toBeGreaterThan(0);
    expect(redrops.every((m) => m.color === MINERAL_COLOR)).toBe(true);
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
