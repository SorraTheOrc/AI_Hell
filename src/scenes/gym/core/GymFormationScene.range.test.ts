/**
 * Gym↔game spawn-range parity (AH-0MUKCLXLW0032R67, child AH-0MUKIXS6C009O79X).
 *
 * `GymFormationScene` positions its formation base through the same shared
 * `resolveSpawnRange`/`pickInRange` code path as `planGroupSpawns`, so a gym
 * and the shipped game cannot diverge for the same config and RNG.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../../core/config';
import { seedConfigStore } from '../../../core/configStore';
import type { EnemyConfig } from '../../../core/configTypes';
import { DEFAULT_ENEMY_CONFIGS } from '../../../core/enemyConfig';
import { planGroupSpawns } from '../../../waves/WaveManager';
import type { WaveGroup } from '../../../waves/Formations';
import { FormationOffset } from '../../../utils/formations';
import { createSeededRng } from '../../../test/powerUpTestFixtures';
import {
  EnemyFormationConfig,
  FormationSceneBullet,
  FormationSceneEntity,
  GymFormationScene,
} from './GymFormationScene';

// The harness drives the fourDirectional control scheme; seed it explicitly.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

/** Minimal entity the base class drives. */
class StubEnemy extends Phaser.GameObjects.Container implements FormationSceneEntity {
  alive = true;
  shootEnabled = false;
  readonly offset: FormationOffset;

  constructor(scene: Phaser.Scene, offset: FormationOffset) {
    super(scene, 0, 0);
    this.offset = offset;
  }

  destroySelf(): void {
    this.alive = false;
  }

  getHitRadius(): number {
    return 10;
  }

  applyFormationPosition(
    baseX: number,
    baseY: number,
    _dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    this.setPosition(
      baseX + this.offset.col * spacingX,
      baseY + this.offset.row * spacingY,
    );
  }
}

/** A bullet the base class can track (unused here). */
class StubBullet implements FormationSceneBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx = 0;
  vy = 0;
  lifetime = 1;
  elapsed = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }
}

type RangeOverrides = Partial<
  Pick<EnemyFormationConfig<StubEnemy, StubBullet>, 'startX' | 'startY' | 'startXMin' | 'startXMax' | 'startYMin' | 'startYMax'>
>;

/** Builds a one-enemy stub scene exposing the resolved base and respawn. */
function makeRangeScene(
  key: string,
  overrides: RangeOverrides,
): new () => GymFormationScene<StubEnemy, StubBullet> & {
  resolvedBase(): { x: number; y: number };
  respawn(): void;
} {
  const config: EnemyFormationConfig<StubEnemy, StubBullet> = {
    sceneKey: key,
    count: 1,
    spacingX: 20,
    spacingY: 20,
    driftSpeed: 0,
    startX: 100,
    startY: 200,
    statusLabel: 'stubs',
    hintText: 'stub range gym',
    buildOffsets: () => [{ row: 0, col: 0 }],
    createEntity: (scene, x, y, offset) => {
      const enemy = new StubEnemy(scene, offset);
      enemy.setPosition(x, y);
      return enemy;
    },
    collectBullets: () => [],
    ...overrides,
  };
  return class StubRangeScene extends GymFormationScene<StubEnemy, StubBullet> {
    constructor() {
      super(config);
    }
    resolvedBase(): { x: number; y: number } {
      return { x: this.formationBaseX, y: this.formationBaseY };
    }
    respawn(): void {
      this.respawnFormation();
    }
  };
}

describe('GymFormationScene — spawn-range parity (AH-0MUKIXS6C009O79X)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('degenerate/absent ranges keep the scalar base unchanged', async () => {
    class Scene extends makeRangeScene('StubRangeDegenerate', {
      startXMin: 100,
      startXMax: 100,
      startYMin: 200,
      startYMax: 200,
    }) {}
    booted = await bootScene([Scene]);
    const scene = booted.scene as InstanceType<typeof Scene>;
    expect(scene.resolvedBase()).toEqual({ x: 100, y: 200 });
  });

  it('draws the base within a genuine configured range', async () => {
    class Scene extends makeRangeScene('StubRangeBounds', {
      startXMin: 50,
      startXMax: 150,
      startYMin: 100,
      startYMax: 300,
    }) {}
    booted = await bootScene([Scene]);
    const scene = booted.scene as InstanceType<typeof Scene>;
    const { x, y } = scene.resolvedBase();
    expect(x).toBeGreaterThanOrEqual(50);
    expect(x).toBeLessThanOrEqual(150);
    expect(y).toBeGreaterThanOrEqual(100);
    expect(y).toBeLessThanOrEqual(300);
  });

  it('re-resolves the base through the injected scene RNG on respawn', async () => {
    class Scene extends makeRangeScene('StubRangeRng', {
      startXMin: 0,
      startXMax: 100,
      startYMin: 200,
      startYMax: 400,
    }) {}
    booted = await bootScene([Scene]);
    const scene = booted.scene as InstanceType<typeof Scene>;
    scene.setSceneRng(() => 0.5);
    scene.respawn();
    expect(scene.resolvedBase()).toEqual({ x: 50, y: 300 });
  });

  it('matches planGroupSpawns base for the same config and RNG (parity)', async () => {
    const overrides: RangeOverrides = {
      startX: 100,
      startY: 200,
      startXMin: 50,
      startXMax: 150,
      startYMin: 100,
      startYMax: 300,
    };
    class Scene extends makeRangeScene('StubRangeParity', overrides) {}
    booted = await bootScene([Scene]);
    const scene = booted.scene as InstanceType<typeof Scene>;
    scene.setSceneRng(createSeededRng(42));
    scene.respawn();
    const gymBase = scene.resolvedBase();

    // Same scalar + range + seed on the game side. The group carries no
    // per-group range, so `planGroupSpawns` reads the archetype range.
    const group: WaveGroup = {
      enemyKey: 'parity-stub',
      formation: 'single',
      count: 1,
      spacingX: 20,
      spacingY: 20,
      startX: 100,
      startY: 200,
    };
    const config: EnemyConfig = {
      ...DEFAULT_ENEMY_CONFIGS.scout,
      startX: 100,
      startY: 200,
      startXMin: 50,
      startXMax: 150,
      startYMin: 100,
      startYMax: 300,
    };
    const spawns = planGroupSpawns([group], false, createSeededRng(42), () => config);

    expect(spawns[0]).toMatchObject({ startX: gymBase.x, startY: gymBase.y });
  });
});
